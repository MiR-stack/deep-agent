import dotenv from 'dotenv'
import {ChatOpenRouter} from '@langchain/openrouter'
import {createDeepAgent} from 'deepagents'
import {HumanMessage, tool} from 'langchain'
import {MultiServerMCPClient} from '@langchain/mcp-adapters'
import { MemorySaver } from '@langchain/langgraph'
import z from 'zod'

dotenv.config()



const getAge = tool(({name})=>{
  return `${name} age is 26`
},{name:'get_age', description:'get anyone age by name',schema:z.object({name:z.string()})})

const getWeather = tool(({city})=>{
  return `today weather of ${city} is 35 degree celcius`
},{name:'get_weather', description:'get weather information by city name',schema:z.object({city:z.string()})})

const mcp = new MultiServerMCPClient({
  langchain_doc:{
    url:'https://docs.langchain.com/mcp'
  }
})

const mcpTools = await mcp.getTools()

console.log(`total ${mcpTools.length} mcp tools is loaded`)

const apiKey = process.env.OPENROUTER_API_KEY

if(!apiKey) throw new Error('api key is missing')
const config = { configurable: { thread_id: "my-thread" } };


function main (modelName:string='gpt-4o-mini'){
  const systemPrompt= 'you are very angry boss'

const model = new ChatOpenRouter({model:modelName,apiKey})

const deepAgent = createDeepAgent({model,systemPrompt,tools:[getAge,getWeather,...mcpTools],checkpointer:new MemorySaver()})


const chat = async (msg:string) =>{
  const res = await deepAgent.invoke({messages:[new HumanMessage(msg)]},config)

  return res.messages.at(-1)?.content
}

return chat
}

const chat = main()

console.log(await chat('hi my name is unicorn and i live in dhaka'))

console.log(await chat('can you tell me what is my age and current weather of my city?'))